/**
 * 补纸页跨组件共享的注入键
 * PaperMatch 页已有全量配纸记录的 liveQuery 订阅，通过 provide 给领用对话框复用，
 * 避免子组件各自再建一个 IndexedDB 订阅。
 */
import type { InjectionKey } from 'vue'
import type { Paper } from '@/types/paper'

/** 取全量配纸记录的函数 */
export const PAPER_LIST_GETTER_KEY: InjectionKey<() => Paper[]> = Symbol('paperListGetter')
