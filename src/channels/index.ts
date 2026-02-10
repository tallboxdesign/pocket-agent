export interface Channel {
  name: string;
  isRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export abstract class BaseChannel implements Channel {
  abstract name: string;
  public isRunning: boolean = false;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
