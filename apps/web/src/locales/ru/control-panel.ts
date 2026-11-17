// The control panel's strings (ru) — one chunk, loaded the first time a
// component asks for any of these namespaces (i18n.ts, controlPanelBackend), not
// with the rest of the language. They are about half of all the strings, and
// only the control panel and a few admin dialogs use them.
import control from "./control.json";
import controlAdmin from "./controlAdmin.json";
import controlDash from "./controlDash.json";

const resources = {
  control,
  controlAdmin,
  controlDash
};

export default resources;
