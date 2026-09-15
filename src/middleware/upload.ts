import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "./errors";

/**
 * A single-file upload handler that reports failures in the API's error shape.
 *
 * Without the translation, multer's own errors reach the error handler as
 * unrecognised objects and surface as a 500 — so a file that is merely too
 * large looks like a server fault rather than a 413 the client can act on.
 *
 * memoryStorage because every caller needs the whole buffer at once anyway, to
 * checksum it and inspect its header.
 */
export function singleFileUpload(
  fieldName: string,
  maxBytes: number,
): (req: Request, res: Response, next: NextFunction) => void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  });

  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(new AppError(413, `File exceeds the maximum size of ${maxBytes} bytes`));
          return;
        }
        next(new AppError(400, `Upload rejected: ${err.message}`));
        return;
      }
      next(err);
    });
  };
}
