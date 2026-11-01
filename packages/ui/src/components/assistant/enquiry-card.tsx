import { makeAssistantDataUI } from "@assistant-ui/react"
import type { Enquiry } from "@workspace/contracts"

/**
 * A quote request from the owner's website (`data-enquiry`): who sent it and
 * how to reach them, their answers under the questions' labels, and their
 * photos, each opening at full size. Every word is the visitor's, shown as
 * text and never as markup or a link it chose.
 */
function EnquiryCard({
  data,
  photoUrl,
}: {
  data: Enquiry
  photoUrl: (id: string) => string
}) {
  return (
    <section
      aria-label={`Quote request from ${data.name}`}
      className="my-3 flex max-w-md flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-card-foreground"
      data-slot="enquiry-card"
    >
      <header className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{data.name}</span>
        <span className="flex flex-wrap gap-x-2 text-muted-foreground text-sm">
          <a className="break-all underline" href={`mailto:${data.email}`}>
            {data.email}
          </a>
          {data.phone && (
            <a className="underline" href={`tel:${data.phone}`}>
              {data.phone}
            </a>
          )}
        </span>
      </header>
      {data.answers.length > 0 && (
        <dl className="grid gap-2 text-sm">
          {data.answers.map((answer) => (
            <div key={answer.label}>
              <dt className="text-muted-foreground">{answer.label}</dt>
              <dd className="whitespace-pre-wrap break-words">
                {answer.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {data.photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-2">
          {data.photos.map((id, i) => (
            <li key={id}>
              <a href={photoUrl(id)} rel="noopener" target="_blank">
                <img
                  alt={`${i + 1} of ${data.photos.length}, sent by ${data.name}`}
                  className="aspect-square w-full rounded-lg object-cover"
                  loading="lazy"
                  src={photoUrl(id)}
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The card, its photos served from where `photoUrl` says. */
export const makeEnquiryCardUI = (photoUrl: (id: string) => string) =>
  makeAssistantDataUI<Enquiry>({
    name: "enquiry",
    render: ({ data }) => <EnquiryCard data={data} photoUrl={photoUrl} />,
  })
