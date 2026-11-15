/**
 * 密钥编解码抽象与信封格式。本文件不得导入 electron，保证可在纯 Node 下单测。
 * 生产实现见 safe-storage-codec.ts。
 */

export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export const ENVELOPE_PREFIX = 'enc:v1:'

/** 仅用于测试的可逆假实现，禁止在生产代码使用 */
export class InsecureTestCodec implements SecretCodec {
  encrypt(plain: string): string {
    return ENVELOPE_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith(ENVELOPE_PREFIX)) return cipher
    return Buffer.from(cipher.slice(ENVELOPE_PREFIX.length), 'base64').toString('utf8')
  }
}

export function isEnvelope(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX)
}
