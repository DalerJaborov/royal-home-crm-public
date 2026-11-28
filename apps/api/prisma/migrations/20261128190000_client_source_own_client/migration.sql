-- «Свой клиент»: только новое значение списка, существующие строки не меняются.
ALTER TYPE "ClientSource" ADD VALUE IF NOT EXISTS 'OWN_CLIENT';
