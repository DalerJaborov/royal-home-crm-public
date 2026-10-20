declare module "heic-decode" {
  interface DecodedHeic {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  /** Изображение контейнера: размеры из заголовка, пиксели — только по decode(). */
  interface LazyHeicImage {
    width: number;
    height: number;
    decode(): Promise<DecodedHeic>;
  }
  function decode(input: { buffer: ArrayBufferLike | Uint8Array }): Promise<DecodedHeic>;
  namespace decode {
    function all(input: { buffer: ArrayBufferLike | Uint8Array }): Promise<LazyHeicImage[] & { dispose(): void }>;
  }
  export default decode;
}
