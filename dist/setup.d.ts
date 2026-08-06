export interface SetupOptions {
    withHook: boolean;
    home?: string;
}
export declare function runSetup(opts: SetupOptions): Promise<void>;
