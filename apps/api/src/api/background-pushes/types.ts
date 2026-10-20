export type BackgroundPushResult = {
  token: string;
  ok: boolean;
  status: number | null;
  apnsId: string | null;
  code?: string;
  reason?: string;
  retryAfterSeconds?: number;
};
