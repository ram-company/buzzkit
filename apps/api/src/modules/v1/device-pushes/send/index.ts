import { SendDevicePushesSchema, sendDevicePushes } from '@buzzkit/api/api/device-pushes/index';
import { auth } from '@buzzkit/api/libs/auth/index';
import { Response } from '@buzzkit/api/libs/response';
import Elysia from 'elysia';

export const devicePushesSend = new Elysia()
  .use(auth)
  .guard({ detail: { tags: ['Device Pushes'] } })
  .post(
    '/device-pushes/send',
    async ({ body, db, tenant }) => {
      const results = await sendDevicePushes(db, tenant, body);
      return Response.success({ results }, { ignoreTransform: ['results'] }).send();
    },
    { tenant: 'messages:send', body: SendDevicePushesSchema }
  );
