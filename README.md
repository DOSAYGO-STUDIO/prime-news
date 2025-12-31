# Primes of Hacker News

Hacker News, but only the items with prime IDs.

## What is this?

Every item on Hacker News has a unique numeric ID. This site filters HN to show only items where that ID is a prime number. Out of ~43 million HN items, about 2.7 million have prime IDs.

## Special Prime Filters

Beyond just primes, we classify items by special prime categories:

| Filter | Description | Count |
|--------|-------------|-------|
| **Mersenne** | Primes of form 2^p - 1 | 7 |
| **Fermat** | Primes of form 2^(2^n) + 1 | 5 |
| **Sophie Germain** | p where 2p+1 is also prime | ~100k |
| **Palindrome** | Reads same forwards/backwards | 781 |
| **p^k+e** | Various power-plus-offset forms | varies |

## The Palindrome Paradox

One of the most fascinating discoveries: **palindromic primes essentially stop at 10 million.**

We found exactly **781 palindromic primes** under 50 million, with the largest being **9,989,899**.

### Why?

It comes down to the **divisibility rule for 11**:

> A number is divisible by 11 if its alternating digit sum equals zero.

For any **even-digit palindrome** like `ABCDDCBA`:
```
A - B + C - D + D - C + B - A = 0
```

This means **all even-digit palindromes are divisible by 11**, and therefore not prime (except 11 itself).

So palindromic primes can only have an **odd number of digits**: 1, 3, 5, or 7 digits. The 7-digit palindromic primes max out at 9,989,899.

The next palindromic prime would need **9 digits** (over 100 million), far beyond HN's current item count.

**This means we've captured all palindromic prime HN items that will ever exist for the foreseeable future!**

## Data Source

The bulk of the data comes from the [HN BigQuery dataset](https://console.cloud.google.com/bigquery?p=bigquery-public-data&d=hacker_news&page=dataset) which contains the full history of Hacker News items.

We export the data, filter for prime IDs using a sieve, and store in sharded SQLite databases for client-side querying. Live data beyond our snapshot comes from the [HN Firebase API](https://github.com/HackerNews/API).

## Technical Details

- **Frontend**: Pure HTML/JS with SQLite WASM for client-side queries
- **Data**: Sharded SQLite databases (~50k items per shard)
- **ETL**: Node.js script with prime sieve and special prime classification
- **Jump-to-Prime**: Uses prime counting function estimators (PNT, Legendre, Li) with iterative refinement
- **Live Mode**: Fetches recent items from HN Firebase API when browsing beyond the database

## Prime Counting Estimators

The "jump to ID" feature uses the Prime Number Theorem to estimate which page contains a given ID:

- **PNT**: π(x) ≈ x / ln(x)
- **Legendre**: π(x) ≈ x / (ln(x) - 1.08366)
- **Li**: Logarithmic integral asymptotic expansion

The iterative probe typically finds the correct page in 2-3 iterations using π(target) - π(landing) correction.

## Links

- [OEIS A000040](https://oeis.org/A000040) - The prime numbers sequence
- [HN Firebase API](https://github.com/HackerNews/API) - Data source
