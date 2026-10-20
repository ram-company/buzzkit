import { SendBackgroundPushesSchema, sendBackgroundPushes } from '@buzzkit/api/api/background-pushes/index';
import { auth } from '@buzzkit/api/libs/auth/index';
import { Response } from '@buzzkit/api/libs/response';
import Elysia from 'elysia';

export const backgroundPushesSend = new Elysia()
  .use(auth)
  .guard({ detail: { tags: ['Background Pushes'] } })
  .post(
    '/background-pushes/send',
    async ({ body, db, tenant }) => {
      const results = await sendBackgroundPushes(db, tenant, body);
      return Response.success({ results }, { ignoreTransform: ['results'] }).send();
    },
    { tenant: 'messages:send', body: SendBackgroundPushesSchema }
  );
