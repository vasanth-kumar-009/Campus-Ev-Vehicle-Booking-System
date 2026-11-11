# Database Schema

MongoDB collections: `users`, `drivers`, `vehicles`, `bookings`, `notifications`.
Password hashes and one-time tokens are stored with `select: false` and are never returned by the API.

## users (passengers and admins)
`name`, `email` (unique, lowercase), `password` (bcrypt), `role` (`student` | `staff` | `admin`), `active`,
`walletBalance` (whole rupees), `emailVerified`, `tokenVersion` (bumped to revoke sessions),
`failedLogins`/`lockUntil` (login lockout), hashed `verifyToken*`/`resetToken*` fields, timestamps.

## drivers
`name`, `email`, `password`, `active`, `status` (`offline` | `online`), `location {lat,lng}`,
`geo` (GeoJSON Point, **2dsphere index** - used for nearest-driver search), `locationUpdatedAt`,
`activeVehicle` (ref vehicles), plus the same auth fields as users.

## vehicles
`type` (`auto` | `bus`), `plate` (unique), `capacity`, `shared` (buses carry several bookings),
`reservedSeats` (changed only by atomic `$inc`), `active`, `driver` (ref drivers).

## bookings
`user`, `driver`, `vehicle`, `pickupName`, `dropName`, `pickupLocation`, `dropLocation`, `seats`, `vehicleType` (`any|auto|bus`),
`status` (`requested` | `accepted` | `completed` | `cancelled` | `expired`; `rejected` is legacy),
`declinedBy[]`, `offerExpiresAt`, `assignedAt/acceptedAt/completedAt/cancelledAt`, `cancelledBy`,
`distanceKm`, `etaMinutes`, `fare`, `paymentMethod` (`cash|wallet`), `paymentStatus` (`pending|paid|due`).
A partial unique index allows at most one open (`requested`/`accepted`) booking per passenger.

## notifications
`recipient`, `recipientType` (`user|driver`), `type`, `message`, `booking`, `read`, `createdAt` (auto-deleted after 7 days).

## Booking lifecycle
```
requested --driver accepts--> accepted --driver completes--> completed
requested --driver declines / offer times out--> requested (offered to the next nearest driver)
requested|accepted --passenger cancels--> cancelled
requested --nobody accepts within MAX_WAIT_MINUTES--> expired
```
