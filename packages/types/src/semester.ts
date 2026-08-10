import { z } from "zod";

export const semesters = ["FIRST", "SUMMER", "SECOND", "WINTER"] as const;

export const semesterSchema = z.enum(semesters);
export type Semester = z.infer<typeof semesterSchema>;

export const academicYearSchema = z.number().int().min(1900).max(2100);

export const academicTermSchema = z
  .object({
    year: academicYearSchema,
    semester: semesterSchema,
  })
  .strict()
  .readonly();

export type AcademicTerm = z.infer<typeof academicTermSchema>;
