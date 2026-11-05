/**
 * 黄历数据：lunar-typescript 本地纯计算(零API零网络)。
 * 注意 getJieQi() 非节气日返回空串而非 null。
 */
import { Solar } from 'lunar-typescript';

export type HoloAlmanac = {
  lunarDate: string;
  ganzhiYear: string;
  jieqi: string | null;
  yi: string[];
  ji: string[];
};

/** 宜/忌截前3条防爆行；库偶发空数组时兜底一条'—'。导出仅为单测。 */
export function trimList(list: string[]): string[] {
  return list.length ? list.slice(0, 3) : ['—'];
}

export function computeAlmanac(date: Date): HoloAlmanac {
  const lunar = Solar.fromDate(date).getLunar();
  return {
    lunarDate: `${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    ganzhiYear: `${lunar.getYearInGanZhi()}${lunar.getYearShengXiao()}年`,
    jieqi: lunar.getJieQi() || null,
    yi: trimList(lunar.getDayYi()),
    ji: trimList(lunar.getDayJi()),
  };
}
