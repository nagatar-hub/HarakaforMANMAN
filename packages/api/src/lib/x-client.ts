export async function verifyCredentials(accessToken: string): Promise<{ id: string; username: string; name: string }> {
  const res = await fetch('https://api.twitter.com/2/users/me?user.fields=username,name', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Verify failed: ${res.status} ${err}`);
  }
  const json = await res.json() as any;
  return json.data;
}

export async function uploadMedia(accessToken: string, imageBuffer: Buffer, mimeType = 'image/png'): Promise<string> {
  const formData = new FormData();
  formData.append('media_data', imageBuffer.toString('base64'));
  formData.append('media_category', 'tweet_image');

  const res = await fetch('https://upload.twitter.com/1.1/media/upload.json', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Media upload failed: ${res.status} ${err}`);
  }
  const json = await res.json() as any;
  return String(json.media_id_string);
}

export async function postTweet(accessToken: string, params: {
  text: string;
  media_ids?: string[];
  reply_to?: string;
}): Promise<{ id: string; text: string }> {
  const body: any = { text: params.text };
  if (params.media_ids?.length) {
    body.media = { media_ids: params.media_ids };
  }
  if (params.reply_to) {
    body.reply = { in_reply_to_tweet_id: params.reply_to };
  }

  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tweet failed: ${res.status} ${err}`);
  }
  const json = await res.json() as any;
  return json.data;
}
