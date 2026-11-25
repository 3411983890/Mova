/**
 * 订阅服务的进程内注册表。
 *
 * 为什么需要它：`main.cjs` 用 `installSubscriptionIpc(...)` 装配服务后并不持有返回值，
 * 而 `model-ipc.cjs` 需要在构造 `runChatAgent` 入参时读到「CLI 路径 / 当前通道 / 引擎」。
 * 与其把 main.cjs 的调用改成赋值再层层传参，不如放一个只有 getter/setter 的注册表：
 * 依赖方向变成「谁需要谁读」，主进程里没有服务转发链。
 *
 * 约束：只存放已经装配好的服务引用，不含任何业务逻辑；未装配时读到的就是 null，
 * 调用方必须按「订阅不可用」处理，不能假设它一定存在。
 */
let current = null;

/** 由 `installSubscriptionIpc` 在装配成功后调用。 */
export function setSubscriptionRuntime(service) {
  current = service ?? null;
  return current;
}

/** 读取当前服务；未装配返回 null。 */
export function getSubscriptionRuntime() {
  return current;
}

/** 测试用：清空注册表，避免用例之间互相影响。 */
export function resetSubscriptionRuntime() {
  current = null;
}
