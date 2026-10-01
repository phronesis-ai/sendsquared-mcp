export const STRIPO_REFERENCE = `# Stripo Email Template Reference

When creating email templates via sendsquared_email_templates_create, you MUST generate
HTML that follows Stripo's markup conventions. This makes the template fully editable
in SendSquared's drag-and-drop visual editor.

## Document skeleton

Every Stripo email starts with this exact wrapper. Do not change the DOCTYPE, xmlns,
or the es-wrapper-color / es-wrapper / esd-email-paddings nesting.

\\\`\\\`\\\`html
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta content="width=device-width, initial-scale=1" name="viewport" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta content="telephone=no" name="format-detection" />
  <title>EMAIL SUBJECT HERE</title>
  <!--[if (mso 16)]><style type="text/css">a{text-decoration:none}</style><![endif]-->
  <!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG></o:AllowPNG><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body>
  <div class="es-wrapper-color">
    <table class="es-wrapper" width="100%" cellspacing="0" cellpadding="0">
      <tbody>
        <tr>
          <td class="esd-email-paddings" valign="top">

            <!-- ALL CONTENT SECTIONS GO HERE -->

          </td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>
\\\`\\\`\\\`

## Content section pattern

Every horizontal section (hero, text block, image, footer, etc.) is a \\\`<table class="es-content">\\\`
containing one stripe. The 600px width is mandatory for email client compatibility.

\\\`\\\`\\\`html
<table class="es-content" cellspacing="0" cellpadding="0" align="center">
  <tbody>
    <tr>
      <td class="esd-stripe" align="center">
        <table class="es-content-body" width="600" cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center">
          <tbody>
            <tr>
              <td class="esd-structure es-p20t es-p20b es-p20r es-p20l" align="left">
                <table width="100%" cellspacing="0" cellpadding="0">
                  <tbody>
                    <tr>
                      <td class="esd-container-frame" width="560" valign="top" align="center">
                        <table width="100%" cellspacing="0" cellpadding="0">
                          <tbody>
                            <tr>
                              <!-- ONE BLOCK goes here (esd-block-text, esd-block-image, etc.) -->
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>
\\\`\\\`\\\`

## Block types

### Text block
\\\`\\\`\\\`html
<td class="esd-block-text es-p10b" align="left">
  <h2 style="color:#333333;font-family:arial,helvetica,sans-serif">Heading Here</h2>
</td>
\\\`\\\`\\\`

\\\`\\\`\\\`html
<td class="esd-block-text" align="left">
  <p style="color:#333333;font-family:arial,helvetica,sans-serif;font-size:16px;line-height:1.6">
    Paragraph text here. Use inline styles on every element.
  </p>
</td>
\\\`\\\`\\\`

### Image block
\\\`\\\`\\\`html
<td class="esd-block-image" align="center" style="font-size:0">
  <a target="_blank" href="https://example.com">
    <img class="adapt-img" src="https://example.com/image.jpg" alt="Description" style="display:block" width="560" />
  </a>
</td>
\\\`\\\`\\\`

### Button block
\\\`\\\`\\\`html
<td class="esd-block-button es-p10t es-p10b" align="center">
  <span class="es-button-border" style="border-style:solid;border-color:#2563eb;background:#2563eb;border-width:0px;display:inline-block;border-radius:6px;width:auto">
    <a href="https://example.com" class="es-button" target="_blank" style="mso-style-priority:100!important;text-decoration:none;color:#ffffff;font-size:18px;padding:10px 30px;display:inline-block;background:#2563eb;border-radius:6px;font-family:arial,helvetica,sans-serif;font-weight:bold;font-style:normal;line-height:120%;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #2563eb">
      Button Text
    </a>
  </span>
</td>
\\\`\\\`\\\`

### Spacer/divider block
\\\`\\\`\\\`html
<td class="esd-block-spacer es-p20t es-p20b" align="center" style="font-size:0">
  <table width="100%" height="100%" cellspacing="0" cellpadding="0" border="0">
    <tbody>
      <tr>
        <td style="border-bottom:1px solid #efefef;background:none;height:1px;width:100%;margin:0px"></td>
      </tr>
    </tbody>
  </table>
</td>
\\\`\\\`\\\`

## Padding utility classes

Use these on \\\`esd-structure\\\` or block \\\`<td>\\\` elements:

- \\\`es-p5t\\\` through \\\`es-p40t\\\` = padding-top (5px increments)
- \\\`es-p5b\\\` through \\\`es-p40b\\\` = padding-bottom
- \\\`es-p5r\\\` through \\\`es-p40r\\\` = padding-right
- \\\`es-p5l\\\` through \\\`es-p40l\\\` = padding-left

Example: \\\`class="esd-structure es-p30t es-p20b es-p20r es-p20l"\\\` = 30px top, 20px bottom/right/left.

## Background colors

Set on the \\\`es-content-body\\\` or \\\`esd-structure\\\` td:
- \\\`bgcolor="#ffffff"\\\` attribute for email clients
- \\\`style="background-color:#2563eb"\\\` for inline CSS

For a colored hero section, set the bgcolor on the \\\`es-content-body\\\` table AND style on the \\\`esd-structure\\\` td.

## Footer section

Use \\\`es-footer\\\` instead of \\\`es-content\\\` for the footer. Must include unsubscribe
and company address merge tokens. Use these exact URLs:

\\\`\\\`\\\`html
<table class="es-footer" cellspacing="0" cellpadding="0" align="center">
  <tbody>
    <tr>
      <td class="esd-stripe" align="center">
        <table class="es-footer-body" width="600" cellspacing="0" cellpadding="0" align="center">
          <tbody>
            <tr>
              <td class="esd-structure es-p20t es-p20b es-p20r es-p20l" align="left">
                <table width="100%" cellspacing="0" cellpadding="0">
                  <tbody>
                    <tr>
                      <td class="esd-container-frame" width="560" valign="top" align="center">
                        <table width="100%" cellspacing="0" cellpadding="0">
                          <tbody>
                            <tr>
                              <td class="esd-block-text" align="center">
                                <p style="font-size:12px;color:#999999;font-family:arial,helvetica,sans-serif">
                                  <strong>{{company.name}}</strong><br>
                                  {{company.address_1}}<br>
                                  {{company.locality}}, {{company.region}} {{company.postal}}
                                </p>
                                <p style="font-size:12px;color:#999999;font-family:arial,helvetica,sans-serif">
                                  <a href="https://list-manage.sendsquared.com/v1/pub/manage/{{company.uuid}}/{{contact.id}}/{{contact.unsubscribe_token}}" style="color:#999999">Manage preferences</a> |
                                  <a href="https://list-manage.sendsquared.com/v1/pub/unsubscribe?id={{contact.id}}&amp;token={{contact.unsubscribe_token}}&amp;unsub_type=campaign&amp;unsub_id={{campaign.id}}" style="color:#999999">Unsubscribe</a>
                                </p>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  </tbody>
</table>
\\\`\\\`\\\`

## Important rules

1. **Every element must use inline styles.** No \\\`<style>\\\` blocks — email clients strip them.
2. **Use tables for layout, not divs.** Outlook and older clients don't support CSS layout.
3. **Always use the nesting pattern**: es-content > esd-stripe > es-content-body[600] > esd-structure > container > esd-block-*.
4. **Each visual row is a separate es-content section.** Don't put multiple blocks in one section — Stripo makes each section independently draggable.
5. **The class names matter.** \\\`esd-block-text\\\`, \\\`esd-block-image\\\`, \\\`esd-block-button\\\` tell the Stripo editor what type of block it is. If you use the wrong class, the block won't be editable with the right tools.
6. **Width 600px on es-content-body.** This is the email standard. The esd-container-frame inside should be 560px (600 minus 20px padding each side).
7. **Do NOT add a SendSquared logo.** The customer's own branding goes in the email.
8. **Always include the footer section** with company merge tokens and unsubscribe/manage-preferences links.
9. **Merge tokens**: \\\`{{contact.first_name}}\\\`, \\\`{{contact.last_name}}\\\`, \\\`{{contact.email}}\\\`, \\\`{{company.name}}\\\`, \\\`{{company.address_1}}\\\`, \\\`{{company.locality}}\\\`, \\\`{{company.region}}\\\`, \\\`{{company.postal}}\\\`, \\\`{{company.uuid}}\\\`, \\\`{{contact.id}}\\\`, \\\`{{contact.unsubscribe_token}}\\\`, \\\`{{campaign.id}}\\\`.
`
