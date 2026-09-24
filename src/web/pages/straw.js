/**
 * CHUỖI THU MUA RƠM — hợp đồng HTX, phiếu mua rơm & công nợ, danh mục ghe.
 *
 *   straw-contracts  Hợp đồng thu mua rơm HTX (US-STRAW-01..03)
 *   straw-tickets     Phiếu thu mua rơm & công nợ (US-STRAW-04..09)
 *   straw-boats       Danh mục ghe (US-STRAW-10..11)
 *
 * Mỗi màn hình chỉ gọi API đúng miền của nó; tài khoản HTX bị khoá vào HTX
 * của mình (server enforce), admin thấy tất cả.
 */
import {
  api, registerPage, el, card, kpi, table, badge, alert, vnd, num, tons,
  pct, dateOnly, state, toast, guard, can, form, navigate, icon, chips,
  modal, confirmDialog, promptDialog, downloadUrl, tabs,
} from '/app.js';