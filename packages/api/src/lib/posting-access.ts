import type { MiddlewareHandler } from "hono";
import { authorizeInternalApiRequest } from "./internal-api-auth.js";

export const postingAccess: MiddlewareHandler = async (c, next) => {
  const auth = authorizeInternalApiRequest(c.req.header("authorization"));
  if (auth === "misconfigured")
    return c.json({ error: "投稿APIの認証設定がありません" }, 503);
  const actor = c.req.header("x-haraka-operator-email");
  if (auth !== "authorized" || !actor || !/^[^\s@]+@[^\s@]+$/.test(actor))
    return c.json({ error: "操作する方のログインが必要です" }, 401);
  c.header("Cache-Control", "no-store");
  await next();
};
