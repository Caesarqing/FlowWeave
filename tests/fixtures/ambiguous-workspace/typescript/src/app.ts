import { load } from './first';
import { load as second } from './second';
import { ghost } from './contracts';
export function start(): string { const label = '中文😀'; load(); return second(); }
export function shadow(load: () => void): void { const label = '中文😀'; load(); ghost(); }
