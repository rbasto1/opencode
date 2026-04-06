import { createHash, randomBytes } from "node:crypto"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { Log } from "@/util/log"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback"
const CONSOLE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize"
const CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
const CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]
const CONSOLE_SCOPES = ["org:create_api_key", "user:profile"]
const ALL_SCOPES = Array.from(new Set([...CONSOLE_SCOPES, ...CLAUDE_AI_SCOPES]))
const OAUTH_BETA = "oauth-2025-04-20"
const FINGERPRINT_SALT = "59cf53e54c78"
const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
const first = new Map<string, string>()
const log = Log.create({ service: "anthropic.auth" })

function parseCode(code: string) {
  return code.split("#", 1)[0]
}

function encode(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function verifier() {
  return encode(randomBytes(32))
}

function challenge(verifier: string) {
  return encode(createHash("sha256").update(verifier).digest())
}

function state() {
  return encode(randomBytes(32))
}

function fingerprint(text: string) {
  const chars = [4, 7, 20].map((i) => text[i] || "0").join("")
  return createHash("sha256").update(`${FINGERPRINT_SALT}${chars}${Installation.VERSION}`).digest("hex").slice(0, 3)
}

function attribution(text: string) {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"
  return `x-anthropic-billing-header: cc_version=${Installation.VERSION}.${fingerprint(text)}; cc_entrypoint=${entry};`
}

async function authurl(mode: "claude" | "console") {
  const code = verifier()
  const csrf = state()
  const url = new URL(mode === "console" ? CONSOLE_AUTHORIZE_URL : CLAUDE_AI_AUTHORIZE_URL)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", MANUAL_REDIRECT_URL)
  url.searchParams.set("scope", ALL_SCOPES.join(" "))
  url.searchParams.set("code_challenge", challenge(code))
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", csrf)
  return {
    state: csrf,
    verifier: code,
    url: url.toString(),
  }
}

async function token(body: Record<string, string>) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    log.error("oauth token request failed", {
      status: response.status,
      body: text,
      grant: body.grant_type,
    })
    return { type: "failed" as const }
  }
  return response.json() as Promise<{
    access_token: string
    refresh_token?: string
    expires_in: number
  }>
}

async function exchange(code: string, state: string, verifier: string) {
  const json = await token({
    grant_type: "authorization_code",
    code: parseCode(code),
    redirect_uri: MANUAL_REDIRECT_URL,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state,
  })
  if ("type" in json) return json
  if (!json.refresh_token) return { type: "failed" as const }
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

async function refresh(refresh: string) {
  const json = await token({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: CLIENT_ID,
    scope: CLAUDE_AI_SCOPES.join(" "),
  })
  if ("type" in json) throw new Error("Token refresh failed")
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? refresh,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function AnthropicAuthPlugin({ client }: PluginInput): Promise<Hooks> {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const msg = output.messages.find((item) => item.info.role === "user")
      if (!msg) return
      const text = msg.parts.find(
        (part): part is Extract<(typeof msg.parts)[number], { type: "text" }> =>
          part.type === "text" && !part.synthetic && !part.ignored,
      )?.text
      if (!text) return
      first.set(msg.info.sessionID, text)
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") return
      const text = input.sessionID ? first.get(input.sessionID) : undefined
      if (text) output.system.unshift(attribution(text))
      if (output.system[text ? 1 : 0]) {
        output.system[text ? 1 : 0] = prefix + "\n\n" + output.system[text ? 1 : 0]
        return
      }
      output.system.push(prefix)
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type === "oauth") {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }
          return {
            apiKey: "",
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const auth = await getAuth()
              if (auth.type !== "oauth") return fetch(input, init)
              if (!auth.access || auth.expires < Date.now()) {
                const next = await refresh(auth.refresh)
                await client.auth.set({
                  path: {
                    id: "anthropic",
                  },
                  body: {
                    type: "oauth",
                    refresh: next.refresh,
                    access: next.access,
                    expires: next.expires,
                  },
                })
                auth.access = next.access
                auth.refresh = next.refresh
                auth.expires = next.expires
              }
              const requestInit = init ?? {}
              const headers = new Headers()
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  headers.set(key, value)
                })
              }
              if (requestInit.headers) {
                new Headers(requestInit.headers).forEach((value, key) => {
                  headers.set(key, value)
                })
              }

              const incoming = headers.get("anthropic-beta") || ""
              const betas = incoming
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
              headers.set("Authorization", `Bearer ${auth.access}`)
              headers.set("anthropic-beta", Array.from(new Set([OAUTH_BETA, ...betas])).join(","))
              headers.set("User-Agent", "claude-cli/2.1.2 (external, cli)")
              headers.delete("x-api-key")

              return fetch(input, {
                ...requestInit,
                headers,
              })
            },
          }
        }
        return {}
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const auth = await authurl("claude")
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => exchange(code, auth.state, auth.verifier),
            }
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const auth = await authurl("console")
            return {
              url: auth.url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                const creds = await exchange(code, auth.state, auth.verifier)
                if (creds.type === "failed") return creds
                const response = await fetch(API_KEY_URL, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${creds.access}`,
                  },
                })
                if (!response.ok) return { type: "failed" as const }
                const json = (await response.json()) as { raw_key?: string }
                if (!json.raw_key) return { type: "failed" as const }
                return { type: "success" as const, key: json.raw_key }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
