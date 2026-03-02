import { z } from 'zod'

const HASHTAG_PATTERN = /(^|\s)#\w+/

export const PinCopySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required.')
    .max(100, 'Title must be 100 characters or less.'),
  description: z
    .string()
    .trim()
    .min(1, 'Description is required.')
    .max(500, 'Description must be 500 characters or less.'),
  alt_text: z.string().trim().max(200).optional(),
  keywords_used: z.array(z.string().trim().min(1)).max(10).optional(),
})

export const PinCopyBatchSchema = z
  .array(PinCopySchema)
  .min(1, 'At least one pin copy item is required.')
  .superRefine((items, context) => {
    items.forEach((item, index) => {
      if (HASHTAG_PATTERN.test(item.title) || HASHTAG_PATTERN.test(item.description)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Hashtags are not allowed in titles or descriptions.',
        })
      }
    })
  })

export type PinCopy = z.infer<typeof PinCopySchema>

export function validatePinCopyBatch(value: unknown): PinCopy[] {
  return PinCopyBatchSchema.parse(value)
}
