/**
 * Electron safeStorage 生产实现：macOS Keychain / Windows DPAPI。
 * 单独成文件，避免纯 Node 测试链路加载 electron。
 */
import { safeStorage } from 'electron'
import { ENVELOPE_PREFIX, type SecretCodec } from './secret-codec'

export class SafeStorageCodec implements SecretCodec {
  encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥服务不可用（safeStorage 未就绪），无法加密保存密钥')
    }
    return ENVELOPE_PREFIX + safeStorage.encryptString(plain).toString('base64')
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith(ENVELOPE_PREFIX)) return cipher
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统密钥服务不可用（safeStorage 未就绪），无法解密已保存的密钥')
    }
    return safeStorage.decryptString(
      Buffer.from(cipher.slice(ENVELOPE_PREFIX.length), 'base64')
    )
  }
}
