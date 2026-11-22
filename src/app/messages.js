const messages = {
  'e.insecure': '请通过 HTTPS 或 localhost 打开页面以启用摄像头。',
  'e.unsupported': '当前浏览器无法访问摄像头。',
  'e.blocked': '摄像头权限被拒绝。请在浏览器中授权后重试。',
  'e.nocam': '未找到可用的摄像头。',
  'e.busy': '摄像头暂不可用。请关闭占用摄像头的应用后重试。',
  'e.load': ({ stage, msg }) => `${stage}失败：${msg}`,
  'stage.camera': '启动摄像头',
  'stage.trackers': '加载追踪模型',
};

export function t(key, variables) {
  const message = messages[key];
  return typeof message === 'function' ? message(variables) : (message ?? key);
}
