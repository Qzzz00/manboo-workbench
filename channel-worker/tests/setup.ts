/**
 * LiveKit Agents 的基类在构造时就取 logger,没初始化过会抛
 * 「logger not initialized」。生产里是 cli/worker 帮忙初始化的,单测里自己来一次。
 * `silent` —— 用例的输出里不该混进框架的 info 日志。
 */
import { initializeLogger } from '@livekit/agents'

initializeLogger({ pretty: false, level: 'silent' })
