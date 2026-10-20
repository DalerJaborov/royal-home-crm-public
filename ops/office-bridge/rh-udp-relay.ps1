# Ретранслятор OpenVPN: TCP (из SSH-тоннеля станции) <-> UDP (на сервер CRM).
# Станция за NAT и сама наружу не выходит, поэтому её OpenVPN работает как tcp-client
# на 127.0.0.1:11194 станции (это обратный SSH-проброс до порта, который выбрал этот скрипт), а здесь пакеты с 2-байтовой длиной
# (формат OpenVPN-over-TCP) превращаются обратно в UDP-датаграммы до 85.198.70.182:1194.
# Содержимое не разбирается: пакеты зашифрованы статическим ключом станции и сервера.
param(
    [int]$FirstPort = 11194,
    [string]$UdpHost = '85.198.70.182',
    [int]$UdpPort = 1194,
    [string]$LogPath = "$PSScriptRoot\relay.log",
    [string]$PortFile = "$PSScriptRoot\relay-port.txt"
)

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

public static class RhUdpRelay
{
    static string logPath;
    static readonly object logLock = new object();

    static void Log(string m)
    {
        try { lock (logLock) { File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + m + "\r\n"); } } catch { }
    }

    static bool ReadFull(Stream s, byte[] b, int n)
    {
        int got = 0;
        while (got < n)
        {
            int r = s.Read(b, got, n - got);
            if (r <= 0) return false;
            got += r;
        }
        return true;
    }

    public static void Run(int firstPort, string udpHost, int udpPort, string log, string portFile)
    {
        logPath = log;
        // порты в зарезервированных Windows диапазонах (netsh excludedportrange) не слушаются: берём первый свободный
        TcpListener l = null;
        int listenPort = 0;
        for (int p = firstPort; p < firstPort + 60 && l == null; p++)
        {
            try { var t = new TcpListener(IPAddress.Loopback, p); t.Start(); l = t; listenPort = p; } catch { }
        }
        if (l == null) throw new Exception("нет свободного порта рядом с " + firstPort);
        File.WriteAllText(portFile, listenPort.ToString());
        Log("слушаю 127.0.0.1:" + listenPort + " -> udp " + udpHost + ":" + udpPort);
        while (true)
        {
            TcpClient c = l.AcceptTcpClient();
            var t = new Thread(() => Handle(c, udpHost, udpPort));
            t.IsBackground = true;
            t.Start();
        }
    }

    static void Handle(TcpClient c, string host, int port)
    {
        Log("станция подключилась");
        UdpClient udp = null;
        try
        {
            c.NoDelay = true;
            Stream ns = c.GetStream();
            udp = new UdpClient();
            udp.Connect(host, port);
            UdpClient u = udp;
            var back = new Thread(() =>
            {
                try
                {
                    var ep = new IPEndPoint(IPAddress.Any, 0);
                    while (true)
                    {
                        byte[] d = u.Receive(ref ep);
                        var frame = new byte[d.Length + 2];
                        frame[0] = (byte)(d.Length >> 8);
                        frame[1] = (byte)(d.Length & 0xff);
                        Buffer.BlockCopy(d, 0, frame, 2, d.Length);
                        lock (ns) { ns.Write(frame, 0, frame.Length); ns.Flush(); }
                    }
                }
                catch { }
                try { c.Close(); } catch { }
            });
            back.IsBackground = true;
            back.Start();

            var hdr = new byte[2];
            while (ReadFull(ns, hdr, 2))
            {
                int len = (hdr[0] << 8) | hdr[1];
                var buf = new byte[len];
                if (!ReadFull(ns, buf, len)) break;
                udp.Send(buf, len);
            }
        }
        catch (Exception e) { Log("ошибка: " + e.Message); }
        finally
        {
            try { if (udp != null) udp.Close(); } catch { }
            try { c.Close(); } catch { }
            Log("станция отключилась");
        }
    }
}
'@

while ($true) {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Move-Item $LogPath "$LogPath.old" -Force }
    try { [RhUdpRelay]::Run($FirstPort, $UdpHost, $UdpPort, $LogPath, $PortFile) }
    catch { Add-Content $LogPath ((Get-Date).ToString('s') + ' relay упал: ' + $_.Exception.Message) }
    Start-Sleep 5
}
