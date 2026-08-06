/** Stable device name: explicit file wins, else hostname's first label. */
export declare function getDeviceName(home?: string): string;
export declare function setDeviceName(name: string, home?: string): void;
