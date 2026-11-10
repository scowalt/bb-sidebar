import type { ComponentProps } from "react";
import { DayPicker } from "react-day-picker";
import { Icon } from "./Icon";
import { cn } from "../lib/utils";

/**
 * react-day-picker styled with the theme tokens, after shadcn/ui's Calendar.
 * The library's own stylesheet is not imported; these classes replace it.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  fixedWeeks = true,
  ...props
}: ComponentProps<typeof DayPicker>) {
  const navButton =
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-30";
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      fixedWeeks={fixedWeeks}
      className={cn("w-fit", className)}
      classNames={{
        months: "relative flex flex-col",
        month: "flex flex-col gap-2",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: navButton,
        button_next: navButton,
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium",
        month_grid: "border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-center text-2xs font-normal text-muted-foreground",
        week: "mt-1 flex",
        day: cn(
          "group/day size-8 p-0 text-center text-sm",
          "data-[outside]:text-muted-foreground data-[disabled]:opacity-40",
        ),
        day_button: cn(
          "inline-flex size-8 items-center justify-center rounded-md outline-none",
          "hover:bg-accent hover:text-accent-foreground focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:pointer-events-none",
          "group-data-[today]/day:font-semibold [[data-today]:not([data-selected])>&]:text-primary",
          "group-data-[selected]/day:bg-primary group-data-[selected]/day:text-primary-foreground group-data-[selected]/day:hover:bg-primary group-data-[selected]/day:hover:text-primary-foreground",
        ),
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) => (
          <Icon name={orientation === "left" ? "ChevronLeft" : "ChevronRight"} className="size-4" aria-hidden="true" />
        ),
      }}
      {...props}
    />
  );
}
