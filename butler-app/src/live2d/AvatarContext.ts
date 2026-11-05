import { createContext, useContext } from 'react';
import type { AvatarState } from './useAvatar';

export const AvatarContext = createContext<AvatarState>({ status: 'loading' });
export function useAvatarState(): AvatarState { return useContext(AvatarContext); }
