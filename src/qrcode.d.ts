/** The part of the `qrcode` package the server uses (it ships no types of its own). */
declare module 'qrcode' {
  const QRCode: {
    toBuffer(
      text: string,
      options?: {
        type?: 'png';
        margin?: number;
        width?: number;
        errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
      },
    ): Promise<Buffer>;
  };
  export default QRCode;
}
