import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cn } from "@workspace/ui/lib/utils"

// shadcn's Base UI tabs, cut to an underline style: the list is a hairline,
// the active tab carries the accent under it, and Base UI supplies the roles,
// arrow keys and the panel's labelling.

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-4", className)}
      data-slot="tabs"
      {...props}
    />
  )
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn("flex items-end gap-4 border-border border-b", className)}
      data-slot="tabs-list"
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "-mb-px inline-flex min-h-9 items-center gap-1.5 rounded-t-sm border-transparent border-b-2 font-medium text-muted-foreground text-sm outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring data-active:border-primary data-active:text-foreground motion-reduce:transition-none",
        className
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        "flex flex-col gap-6 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring data-hidden:hidden",
        className
      )}
      data-slot="tabs-content"
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
