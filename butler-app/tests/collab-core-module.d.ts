/** 测试运行真实 core；手机 tsc 不把另一工程的编译选项带进来。 */
declare module '#collab-real-core' {
  export interface CollabQaCore {
    port: number;
    close(): Promise<void>;
  }
  export function startCollabQaCore(options: { dir: string; port?: number }): Promise<CollabQaCore>;
}
