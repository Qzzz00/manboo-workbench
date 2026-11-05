/**
 * 界面上怎么写用户自己(2026-10-22 新 UI 第三轮 8,维护者:名片、便签上不写「你」,写账号名)。
 *
 * 名字取 `/state.me.name`(引导里答的称呼,没有就本机账号的用户名,服务端拼);
 * 两样都没有时写「我」—— 仍然不写「你」。
 */
import { createContext, useCallback, useContext } from 'react'
import { assigneeName } from '../protocol.ts'

export const ME_FALLBACK = '我'

const MeNameContext = createContext<string>(ME_FALLBACK)

export function MeNameProvider({ name, children }: { name: string | undefined, children: React.ReactNode }) {
  return <MeNameContext.Provider value={name === undefined || name.trim() === '' ? ME_FALLBACK : name}>{children}</MeNameContext.Provider>
}

export function useMeName(): string {
  return useContext(MeNameContext)
}

/** `assigneeName` 的界面版:`me` 换成账号名,其余照旧。 */
export function useAssigneeName(): (id: string | undefined) => string {
  const me = useMeName()
  return useCallback((id: string | undefined) => (id === 'me' ? me : assigneeName(id)), [me])
}
