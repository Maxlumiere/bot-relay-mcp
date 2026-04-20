// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

declare module "sql.js" {
  function initSqlJs(config?: any): Promise<any>;
  export default initSqlJs;
}
