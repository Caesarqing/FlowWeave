export function execute(value: string): string;
export function execute(value: number): number;
export function execute(value: string | number): string | number { return value; }
