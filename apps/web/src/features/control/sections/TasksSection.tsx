import { useTranslation } from "react-i18next";
import { ListTodo } from "lucide-react";
import { ControlSectionHead } from "../ControlSectionHead";
import { TasksView } from "./dashboard/TasksView";

// Maintenance › Tasks — was the Dashboard's Tasks view. It polls on its own.
export function TasksSection() {
  const { t } = useTranslation(["common", "controlDash"]);
  return (
    <>
      <ControlSectionHead
        section="tasks"
        icon={<ListTodo size={30} />}
        description={t("controlDash:dash.tasksDescription")}
      />
      <TasksView />
    </>
  );
}
