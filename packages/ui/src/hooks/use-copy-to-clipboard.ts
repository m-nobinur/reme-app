import { useState } from "react"

export type UseCopyToClipboardOptions = {
  copiedDuration?: number
}

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false)

  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
      return
    }

    navigator.clipboard.writeText(value).then(
      () => {
        setIsCopied(true)
        setTimeout(() => setIsCopied(false), copiedDuration)
      },
      // A refused clipboard leaves the button as it was, which is the
      // truthful state: nothing was copied.
      () => undefined
    )
  }

  return { isCopied, copyToClipboard }
}
