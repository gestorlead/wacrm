/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Browser driver for Meta's WhatsApp Embedded Signup ("Connect with
// Facebook") popup. Lazily loads the Facebook JS SDK the first time it's
// used — so the SDK isn't pulled into every page — then runs FB.login
// with the Coexistence feature type.
//
// The flow yields TWO async signals in no guaranteed order: the auth
// `code` (FB.login callback) and the WABA identifiers (a postMessage
// event). We hold both and resolve once both have arrived. Resolves
// `null` when the user cancels; rejects on SDK load / signup errors.

declare global {
  interface Window {
    FB?: any
    fbAsyncInit?: () => void
  }
}

export interface EmbeddedSignupResult {
  code: string
  waba_id: string
  phone_number_id: string
  business_id: string
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js'
const SDK_ELEMENT_ID = 'facebook-jssdk'

/** True when the public env needed to launch the popup is present. */
export function isEmbeddedSignupConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_META_APP_ID && process.env.NEXT_PUBLIC_META_CONFIG_ID
  )
}

function loadSdk(appId: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Embedded Signup must run in the browser.'))
      return
    }
    if (window.FB) {
      resolve()
      return
    }
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version, xfbml: false, autoLogAppEvents: true })
      resolve()
    }
    // If the script tag is already in flight, fbAsyncInit (set above)
    // will fire once it loads — don't inject a second copy.
    if (document.getElementById(SDK_ELEMENT_ID)) return
    const script = document.createElement('script')
    script.id = SDK_ELEMENT_ID
    script.src = SDK_SRC
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => reject(new Error('Failed to load the Facebook SDK.'))
    document.body.appendChild(script)
  })
}

export async function runEmbeddedSignup(): Promise<EmbeddedSignupResult | null> {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID
  const configId = process.env.NEXT_PUBLIC_META_CONFIG_ID
  const version = process.env.NEXT_PUBLIC_META_API_VERSION || 'v22.0'
  if (!appId || !configId) {
    throw new Error(
      'Embedded Signup is not configured (set NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_CONFIG_ID).'
    )
  }

  await loadSdk(appId, version)

  return new Promise<EmbeddedSignupResult | null>((resolve, reject) => {
    let code: string | null = null
    let businessData: Omit<EmbeddedSignupResult, 'code'> | null = null
    let settled = false

    const settle = (fn: (v: any) => void, value: any) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', messageHandler)
      fn(value)
    }

    const resolveIfReady = () => {
      if (!code || !businessData) return
      settle(resolve, { code, ...businessData })
    }

    // Hoisted function declaration so `settle` (above) can reference it
    // before this point in source without a `let` binding.
    function messageHandler(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return
      let data: any
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return

      if (
        data.event === 'FINISH' ||
        data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
      ) {
        const d = data.data ?? {}
        if (!d.business_id || !d.waba_id) {
          settle(reject, new Error('Embedded Signup returned incomplete business data.'))
          return
        }
        businessData = {
          waba_id: d.waba_id,
          phone_number_id: d.phone_number_id || '',
          business_id: d.business_id,
        }
        resolveIfReady()
      } else if (data.event === 'CANCEL') {
        settle(resolve, null)
      } else if (data.event === 'error') {
        settle(reject, new Error(data.data?.error_message || 'Embedded Signup error.'))
      }
    }
    window.addEventListener('message', messageHandler)

    window.FB!.login(
      (response: any) => {
        if (response?.authResponse?.code) {
          code = response.authResponse.code
          resolveIfReady()
        } else {
          // Popup dismissed or permission denied — treat as a cancel.
          settle(resolve, null)
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      }
    )
  })
}
