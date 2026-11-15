import type { BtvApi } from '../../shared/api-contract'

declare global {
  interface Window {
    btv: BtvApi
  }
}

export {}
