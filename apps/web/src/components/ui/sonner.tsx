"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, toast as sonnerToast } from "sonner";
import { setNotifier } from "@/core/notifications";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// kneecap M2: the headless engine emits notifications through
// `@/core/notifications` instead of importing sonner. This module is the web
// host's renderer for that port. Bound at module scope so it is installed for
// every route the moment the root layout's <Toaster /> module is evaluated —
// including the project-list routes, which surface engine errors without ever
// mounting the editor.
setNotifier(({ level, message, description, duration, action }) => {
	sonnerToast[level](message, { description, duration, action });
});

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			position="bottom-right"
			offset={20}
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
					description: "group-[.toast]:text-muted-foreground",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			expand={false}
			richColors
			{...props}
		/>
	);
};

export { Toaster };
