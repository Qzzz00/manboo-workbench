export const MOUTH_PARAM_IDS = ['ParamMouthOpenY', 'ParamMouthForm'] as const;
export type MouthParamId = (typeof MOUTH_PARAM_IDS)[number];

export const MOUTH_PARAM_IDS_SET = new Set<string>(MOUTH_PARAM_IDS);

export function isMouthParam(id: string): id is MouthParamId {
  return MOUTH_PARAM_IDS_SET.has(id);
}
