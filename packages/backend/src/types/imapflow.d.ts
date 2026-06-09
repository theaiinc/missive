declare module "imapflow" {
  export interface MailboxStatus {
    messages: number;
    recent: number;
    unseen: number;
    uidNext: number;
    uidValidity: number;
    highestModseq: string;
  }

  type ImapFlowAuth =
    | { user: string; pass: string }
    | { user: string; accessToken: string };

  export class ImapFlow {
    constructor(config: {
      host: string;
      port: number;
      secure: boolean;
      tls?: { rejectUnauthorized?: boolean };
      disableAutoIdle?: boolean;
      auth: ImapFlowAuth;
      logger?: boolean | { debug?: (msg: any) => void; info?: (msg: any) => void; warn?: (msg: any) => void; error?: (msg: any) => void };
    });
    connect(): Promise<void>;
    logout(): Promise<void>;
    getMailboxLock(path: string): Promise<{ release: () => void }>;
    mailboxOpen(path: string): Promise<any>;
    status(
      path: string,
      query: { messages?: boolean; recent?: boolean; unseen?: boolean; uidNext?: boolean; uidValidity?: boolean; highestModseq?: boolean }
    ): Promise<MailboxStatus>;
    fetch(
      range: string | object,
      options: { uid?: boolean; source?: boolean; envelope?: boolean; internalDate?: boolean }
    ): AsyncIterable<{
      uid: number;
      source?: Buffer;
      envelope?: any;
      internalDate?: Date;
      [key: string]: any;
    }>;
  }
}
