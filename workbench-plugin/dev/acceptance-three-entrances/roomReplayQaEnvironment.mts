/** Opt-in controlled QA process environment only; normal workers remain untouched. */
import { isolateRoomReplayQaTextTurn } from './phonePorts.ts'
isolateRoomReplayQaTextTurn(process.env)
