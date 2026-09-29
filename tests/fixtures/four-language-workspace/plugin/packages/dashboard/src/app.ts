import { load as read } from '@fixture/core/service';
export function start(): string {
  const label = '你好'; read();
  return read();
}
