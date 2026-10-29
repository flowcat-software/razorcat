# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: on GitHub, open the
repository's **Security** tab and choose **Report a vulnerability**. Include the Razorcat
version (Settings › About), your Windows version and the steps to reproduce.

You'll get a reply within a week. Fixes ship in the next release, and the release notes credit
you unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes. Install new versions over the old one from the
[Releases](https://github.com/flowcat-software/razorcat/releases) page.

## Checking a download

Each installer comes with a SHA-256 checksum (`SHA256SUMS.txt` on its release). Updates that
Razorcat installs itself are signed, and Razorcat refuses one whose signature doesn't match the
key built into it.
