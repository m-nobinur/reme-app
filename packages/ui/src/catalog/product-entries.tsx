import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { DefinitionList } from "@workspace/ui/components/definition-list"
import { OrgTree } from "@workspace/ui/components/org-tree"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import type { ReactNode } from "react"

/**
 * Catalog entries for the product screens' primitives. A compound component
 * gets one entry per exported name, all rendering the same composed sample:
 * a `TableCell` on its own is not a table, and an entry that renders invalid
 * markup would have axe reporting on something nobody ships.
 *
 * Everything here is invented. Brightclean is a fixture organisation and the
 * customers are numbered rather than named.
 */

type Entry = { name: string; render: () => ReactNode }

function CardSample() {
  return (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>This week</CardTitle>
        <CardDescription>Six enquiries, four answered</CardDescription>
        <CardAction>
          <Badge variant="secondary">Fixture</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        Every enquiry got a first reply inside four minutes.
      </CardContent>
      <CardFooter className="border-t">
        <Button variant="outline">Open the pipeline</Button>
      </CardFooter>
    </Card>
  )
}

function TableSample() {
  return (
    <Table>
      <TableCaption>Three of eight staff.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          <TableHead scope="col">Code</TableHead>
          <TableHead scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Maya</TableCell>
          <TableCell>COS-001</TableCell>
          <TableCell>
            <Badge variant="secondary">Active</Badge>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Daniel</TableCell>
          <TableCell>OPS-001</TableCell>
          <TableCell>
            <Badge variant="secondary">Active</Badge>
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Sam</TableCell>
          <TableCell>QA-001</TableCell>
          <TableCell>
            <Badge variant="outline">Paused</Badge>
          </TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Two active, one paused.</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  )
}

const active = <Badge variant="secondary">Active</Badge>

/**
 * The brightclean reporting line, in the shape the staff page draws it: one
 * root, four reports under the Chief of Staff, two under the Ops Manager, and
 * one of those paused. `packages/ui` cannot import `@workspace/db`, so this is
 * written out rather than read from the fixtures. It is written out to the
 * same shape on purpose: this entry is the only place the tree can be looked
 * at without signing in, and a single unbranching chain would not show what a
 * level with siblings in it looks like.
 */
const TREE = [
  {
    id: "own",
    title: "Dana Reyes",
    subtitle: "Owner",
    code: "OWN-001",
    badge: active,
    reports: [
      {
        id: "cos",
        title: "Maya",
        subtitle: "Chief of Staff",
        code: "COS-001",
        badge: active,
        reports: [
          {
            id: "dev",
            title: "Alex",
            subtitle: "Developer",
            code: "DEV-001",
            badge: active,
            reports: [],
          },
          {
            id: "gro",
            title: "Nora",
            subtitle: "Growth",
            code: "GRO-001",
            badge: active,
            reports: [],
          },
          {
            id: "css",
            title: "Jamie",
            subtitle: "Client Services",
            code: "CSS-001",
            badge: active,
            reports: [],
          },
          {
            id: "ops",
            title: "Daniel",
            subtitle: "Ops Manager",
            code: "OPS-001",
            badge: active,
            reports: [
              {
                id: "bkg",
                title: "Priya",
                subtitle: "Booking Coordinator",
                code: "BKG-001",
                badge: active,
                reports: [],
              },
              {
                id: "qa",
                title: "Sam",
                subtitle: "QA Coordinator",
                code: "QA-001",
                badge: <Badge variant="outline">Paused</Badge>,
                reports: [],
              },
            ],
          },
        ],
      },
    ],
  },
]

/** All four target kinds, because a union that renders three is a bug. */
function TargetSample() {
  return (
    <div className="flex max-w-md flex-col gap-2">
      <ApprovalTargetSummary
        target={{ kind: "revision", revision_id: "rev_2f41c9" }}
      />
      <ApprovalTargetSummary
        target={{ kind: "domain", hostname: "brightclean.invalid" }}
      />
      <ApprovalTargetSummary
        target={{ kind: "spend", amount_usd: 84, currency: "USD" }}
      />
      <ApprovalTargetSummary
        target={{
          kind: "sensitive_claim",
          fact_id: "10000001-0000-4000-8000-000000000044",
          claim: "Fully insured and bonded",
        }}
      />
    </div>
  )
}

const productCatalog: Entry[] = [
  {
    name: "Badge",
    render: () => (
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Active</Badge>
        <Badge variant="secondary">Quoted</Badge>
        <Badge variant="outline">Paused</Badge>
        <Badge variant="destructive">Alert</Badge>
        <Badge variant="ghost">Draft</Badge>
        <Badge variant="link">Link</Badge>
      </div>
    ),
  },
  { name: "Card", render: () => <CardSample /> },
  { name: "CardHeader", render: () => <CardSample /> },
  { name: "CardTitle", render: () => <CardSample /> },
  { name: "CardDescription", render: () => <CardSample /> },
  { name: "CardAction", render: () => <CardSample /> },
  { name: "CardContent", render: () => <CardSample /> },
  { name: "CardFooter", render: () => <CardSample /> },
  { name: "Table", render: () => <TableSample /> },
  { name: "TableHeader", render: () => <TableSample /> },
  { name: "TableBody", render: () => <TableSample /> },
  { name: "TableFooter", render: () => <TableSample /> },
  { name: "TableHead", render: () => <TableSample /> },
  { name: "TableRow", render: () => <TableSample /> },
  { name: "TableCell", render: () => <TableSample /> },
  { name: "TableCaption", render: () => <TableSample /> },
  {
    name: "OrgTree",
    render: () => (
      <OrgTree aria-label="Reporting lines" className="max-w-xl" nodes={TREE} />
    ),
  },
  { name: "ApprovalTargetSummary", render: () => <TargetSample /> },
  {
    name: "DefinitionList",
    render: () => (
      <DefinitionList
        className="max-w-sm"
        items={[
          {
            id: "phone",
            term: "Phone",
            description: "+15550142",
            meta: "You told Reme · version 1 · checked 6 Jan 2026",
          },
          {
            id: "hours",
            term: "Weekday",
            description: "08:00 to 17:00",
            meta: "You told Reme · version 1 · checked 6 Jan 2026",
          },
          {
            id: "area",
            term: "Service area",
            description: "Fairhaven, within 25 km",
            meta: "You told Reme · version 2 · checked 6 Jan 2026",
          },
        ]}
      />
    ),
  },
]

export { productCatalog }
