import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 60000 });

// 统一把后端错误信息挑出来，前端直接 message.error 即可
api.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err?.response?.data?.error || err?.message || '请求失败';
    (err as any).friendlyMessage = msg;
    return Promise.reject(err);
  }
);

export default api;
