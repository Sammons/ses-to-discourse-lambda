import { SESEvent, SESHandler } from "aws-lambda";
import { S3 } from "@aws-sdk/client-s3";
import * as aws from "@aws-sdk/client-ses";
import { ParsedMail, simpleParser } from "mailparser";
import { Readable } from "stream";
import { Blob } from "buffer";
import { createTransport } from "nodemailer";

const ses = new aws.SES({
  apiVersion: "2010-12-01",
  region: "us-east-1",
});

const transporter = createTransport({
  SES: { ses, aws },
});

const Constants = {
  EmailStorageBucket: process.env.EMAIL_STORAGE_BUCKET,
  DiscourseApiKey: process.env.DISCOURSE_API_KEY,
  DiscourseHostWithProtocol: process.env.DISCOURSE_HOST,
  DiscoursePostCategoryNum: process.env.DISCOURSE_CATEGORY_NUM,
  EmailToNotifyOnFailure: process.env.EMAIL_TO_NOTIFY_ON_FAILURE,
  EmailToSendFrom: process.env.EMAIL_TO_SEND_FROM,
  NameToSendFrom: process.env.NAME_TO_SEND_FROM || "Discourse",
  MagicMaxBytesSes: 10485760,
};

Object.keys(Constants).forEach((key) => {
  if (!Constants[key]) {
    console.warn("Invalid environment config, missing", key);
    throw new Error(`Invalid environment config, missing ${key}`);
  }
});

type DiscourseUploadResponse = {
  id: string;
  url: string;
  original_filename: string;
  filesize: number;
  width: number;
  height: number;
  thumbnail_width: number;
  thumbnail_height: number;
  extension: string;
  short_url: string;
  short_path: string;
  retain_hours: string | null;
  human_filesize: string;
  dominant_color: string | null;
};

const CommonDiscourseHeaders = (username?: string) => ({
  "Api-Key": Constants.DiscourseApiKey,
  "Api-Username": username || "system",
});

const objToFormData = (o: object) => {
  const formData = new FormData();
  for (const key in o) {
    formData.append(key, o[key] instanceof Blob ? o[key] : String(o[key]));
  }
  return formData;
};

const uploadDiscourseFile = async (
  username: string,
  attachment: ParsedMail["attachments"][number],
) => {
  const result = await fetch(`${Constants.DiscourseHostWithProtocol}/uploads`, {
    method: "POST",
    headers: {
      ...CommonDiscourseHeaders(username),
    },
    body: objToFormData({
      type: "composer",
      synchronous: true,
      file: new Blob([attachment.content]),
    }),
  });
  if (result.statusText != "OK") {
    console.error(`Failure in response in upload`, {
      headers: JSON.stringify(result.headers),
      body: await result.text(),
    });
    throw new Error(`Unsuccessful upload`);
  }
  const responseForm = await result.json();
  return responseForm as DiscourseUploadResponse;
};

const retrieveMatchingDiscourseUsersByEmail = async (email: string) => {
  const result = await fetch(
    `${Constants.DiscourseHostWithProtocol}/admin/users/list/active.json?email=${encodeURIComponent(email)}`,
    {
      headers: CommonDiscourseHeaders(),
    },
  );
  if (result.statusText != "OK") {
    console.error(`Failure in response attempting to test email`, {
      headers: JSON.stringify(result.headers),
      body: await result.text(),
    });
    throw new Error(`Unsuccessful email test`);
  }
  return (await result.json()) as { id: number; username: string }[];
};

const createDiscoursePublicReportPost = async (
  parsedMail: ParsedMail,
  username: string,
  attachments: Pick<
    DiscourseUploadResponse,
    "dominant_color" | "original_filename" | "url"
  >[],
) => {
  const result = await fetch(`${Constants.DiscourseHostWithProtocol}/posts`, {
    method: "POST",
    headers: CommonDiscourseHeaders(username),
    body: objToFormData({
      title: `This is a public report by email: ${parsedMail.subject}`,
      category: Constants.DiscoursePostCategoryNum,
      archetype: "regular",
      unlisted: true,
      raw: `Email:\n${parsedMail.html || parsedMail.text}\n${attachments
        .map((a) =>
          a.dominant_color
            ? `![${a.original_filename}](${a.url})`
            : `[${a.original_filename}](${a.url})`,
        )
        .join("\n\n")}`,
    }),
  });
  if (result.statusText != "OK") {
    console.error(`Failure in response attempting to create post`, {
      headers: JSON.stringify(result.headers),
      body: await result.text(),
    });
    throw new Error(`Unsuccessful report post test`);
  }
  return;
};

const s3 = new S3({
  region: "us-east-1",
});

const parseEmailFromS3 = async (messageId: string) => {
  try {
    const messageS3File = `email/${messageId}`;
    const object = await s3.getObject({
      Bucket: Constants.EmailStorageBucket,
      Key: messageS3File,
    });
    // if (
    //   object.ContentLength &&
    //   object.ContentLength >= Constants.MagicMaxBytesSes
    // ) {
    //   throw new Error(`Email too large to handle`);
    // }
    if (!object.Body) {
      console.log(`Missing body from email ${messageId}`);
      return;
    }
    return simpleParser(object.Body as Readable);
  } catch (e) {
    console.error("Failed to parse mail", e);
    await transporter.sendMail({
      to: [Constants.EmailToNotifyOnFailure],
      from: {
        address: Constants.EmailToSendFrom,
        name: Constants.NameToSendFrom,
      },
      subject: `Failed to parse: ${messageId}`,
      text: `Error: ${e.message}`,
    });
    return null;
  }
};

const uploadAttachmentsFromParsedEmail = async (
  username: string,
  parsedMail: ParsedMail,
) => {
  const uploads: Awaited<ReturnType<typeof uploadDiscourseFile>>[] = [];
  const settled = await Promise.allSettled(
    parsedMail.attachments.map(async (attachment) => {
      uploads.push(await uploadDiscourseFile(username, attachment));
    }),
  );
  let failures = false;
  settled.forEach((upload) => {
    if (upload.status === "rejected") {
      console.warn(`Failed upload`, upload.reason);
      failures = true;
    }
  });
  if (failures) {
    throw new Error(`Incomplete uploads!`);
  }
  console.log(
    `Processed ${uploads.length} uploads: ${uploads.map((u) => u.id).join(",")}`,
  );
  return uploads;
};

const processRecord = async (record: SESEvent["Records"][number]) => {
  const parsedMail = await parseEmailFromS3(record.ses.mail.messageId);
  if (!parsedMail) {
    console.log("No parsed mail, returning early");
    return;
  }
  try {
    console.log("retrieving user", parsedMail.from.value[0].address);
    const reportingUserMatches = await retrieveMatchingDiscourseUsersByEmail(
      parsedMail.from.value[0].address,
    );
    if (reportingUserMatches.length === 0) {
      console.warn(
        `No matching user, sending email to sender cc'ing  ${Constants.EmailToNotifyOnFailure}`,
      );
      await transporter.sendMail({
        to: parsedMail.from.value.map((v) => v.address),
        from: {
          address: Constants.EmailToSendFrom,
          name: Constants.NameToSendFrom,
        },
        cc: [Constants.EmailToNotifyOnFailure],
        subject: `Email not matching forum user - ${parsedMail.subject}`,
        text: `Hello, thanks for your report. The report was not auto-entered because your email is not registered. We will reach out soon!`,
        html: parsedMail.html ? parsedMail.html : undefined,
        attachments: parsedMail.attachments.map((a) => ({
          cid: a.cid,
          content: a.content,
          contentType: a.contentType,
          contentDisposition: a.contentDisposition as "attachment" | "inline",
          filename: a.filename,
        })),
      });
      return;
    }
    const username = reportingUserMatches[0].username;
    // if not found then email them back that they need to reach out for an invite
    console.log("uploading attachments");
    const uploads = await uploadAttachmentsFromParsedEmail(
      username,
      parsedMail,
    );
    await createDiscoursePublicReportPost(parsedMail, username, uploads);
    console.log("Success!");
  } catch (e) {
    console.error(e);
    await transporter.sendMail({
      to: [Constants.EmailToNotifyOnFailure],
      from: {
        address: Constants.EmailToSendFrom,
        name: Constants.NameToSendFrom,
      },
      subject: `Failed to send to discourse: ${parsedMail.subject}`,
      text: parsedMail.text,
      html: parsedMail.html ? parsedMail.html : undefined,
      attachments: parsedMail.attachments.map((a) => ({
        cid: a.cid,
        content: a.content,
        contentType: a.contentType,
        contentDisposition: a.contentDisposition as "attachment" | "inline",
        filename: a.filename,
      })),
    });
  }
};

export const handler: SESHandler = async (event: SESEvent) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
