export interface RoutableMessage {
  to: { device?: string };
}

export type Route = { kind: 'local' } | { kind: 'relay'; device: string };

/** A message is local when its target device is unset or equals this device (ci). */
export function routeForMessage(message: RoutableMessage, selfDevice: string): Route {
  const target = message.to.device?.trim();
  if (!target || target.toLowerCase() === selfDevice.toLowerCase()) return { kind: 'local' };
  return { kind: 'relay', device: target };
}
