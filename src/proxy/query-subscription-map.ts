let nextId = 0;

export function generateSubscriptionId(): string {
  return `sub-${++nextId}`;
}
