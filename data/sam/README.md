# SAM Coupé symbol maps

`samrom.map` (ROM 3.0 and the BASIC system variables), `samdos2.map`
(SAMDOS 2.2) and `samports.map` (the I/O ports) are SimCoupe's, from its
`Resource/` folder: https://github.com/simonowen/simcoupe

SimCoupe is Copyright (c) 1999-2024 Simon Owen and others, free software under
the GNU General Public License, version 2 or (at your option) any later
version; these files come with it under the same terms. The SAM page's
debugger (ui/sam-debug.js, core/sam/sam-symbols.js) reads them as they are.

Format: `ADDR=NAME`, hex, one a line; `;` starts a comment. In the ports map
a write-only port is `80xx` (bit 15 set), and a blank name means the port has
no name in that direction.
