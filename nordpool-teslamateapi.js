// Charge start window is the next full hour, for chargeWindowLength hours
const chargeWindowLength = 8

// How many percentage points of charge the car gains in one hour
const chargePercentagePointsPerHour = 9

// How many percentage points the charge rate drops below 0°C, per each °
const chargePercentagePointsPerHourColdFactor = 0.7

// Nordpool market area
const nordpoolArea = "FI"

// Name of the 'home' geolocation
const homeGeolocationName = "Koti"

try {
    const nordpool = new Nordpool.Prices()

    // 'Car Dashboards' saves the topics into global context in format [value, timestamp]
    const geofence = global.get("geofence")[0]
    const battery_level = global.get("battery_level")[0]
    const charging_state = global.get("charging_state")[0]
    const charge_limit_soc = global.get("charge_limit_soc")[0]
    const outside_temp = global.get("outside_temp")[0]

    if (geofence != homeGeolocationName || charging_state != "Stopped") {
        node.status({ text: `Not plugged in at home: ${geofence || "-"}/${charging_state || "-"}` })
        return null
    }

    const percentPointsPerHour = chargePercentagePointsPerHour + chargePercentagePointsPerHourColdFactor * (outside_temp < 0 ? outside_temp : 0)
    const chargeHours = Math.ceil((charge_limit_soc - battery_level) / percentPointsPerHour)

    let tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0)

    node.status({ text: "Fetching Nordpool prices" })

    const todayPrices = await nordpool.hourly({ area: nordpoolArea })
    const tomorrowPrices = await nordpool.hourly({ area: nordpoolArea, from: tomorrow })
    const nordpoolPrices = Enumerable.from(todayPrices.concat(tomorrowPrices))

    node.status({ text: "Nordpool prices fetched" })

    // Charge start window is the next full hour
    let chargeStartTime = new Date()
    chargeStartTime.setHours(chargeStartTime.getHours() + 1)
    chargeStartTime.setMinutes(0, 0, 0)

    const pricesSinceElevenPM = nordpoolPrices.where(
        i => new Date(i.date).getTime() >= chargeStartTime.getTime()
    ).take(chargeWindowLength)
    const hoursToConsider = pricesSinceElevenPM.take(pricesSinceElevenPM.count() - chargeHours)
    let startHourPrices = []

    hoursToConsider.toArray().forEach(
        (price, index) =>
            startHourPrices.push({ date: price.date, price: pricesSinceElevenPM.skip(index).take(chargeHours).sum(i => i.value) })
    )

    const cheapestStartHours = Enumerable.from(startHourPrices).orderBy(i => i.price)
    const startTime = new Date(cheapestStartHours.first().date)
    const startHour = new Date(cheapestStartHours.first().date).getHours()
    const startDelay = startTime.getTime() - new Date().getTime() - 60 * 1000
    node.status({ text: `Charge at: ${startHour.toString().padStart(2, '0')}:00 for ${chargeHours} hours` })

    return [
        {
            "delay": startDelay.toString()
        },
        {
            "payload": {
                "time": startHour * 60,
                "enable": "true"
            }
        }
    ]
} catch (e) {
    node.warn(`Exception: ${e}`)

    // defaults:
    // * 4 minutes delay -> 22:59 if this executes at 22:55
    // * 23:00 charge start time
    return [
        {
            "delay": (4 * 60 * 1000).toString()
        },
        {
            "payload": {
                "time": 23 * 60,
                "enable": "true"
            }
        }
    ]
}