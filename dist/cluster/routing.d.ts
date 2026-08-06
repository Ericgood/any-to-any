export interface RoutableMessage {
    to: {
        device?: string;
    };
}
export type Route = {
    kind: 'local';
} | {
    kind: 'relay';
    device: string;
};
/** A message is local when its target device is unset or equals this device (ci). */
export declare function routeForMessage(message: RoutableMessage, selfDevice: string): Route;
