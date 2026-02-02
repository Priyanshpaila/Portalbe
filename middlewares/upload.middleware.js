import multer, { diskStorage } from "multer"
import { existsSync, mkdirSync } from "fs"

const multerStorage = diskStorage({
	destination: (req, file, cb) => {
		const dirPath = `uploads/${req.params.id}`
		if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
		cb(null, dirPath)
	},
	filename: (req, file, cb) => {
		cb(null, file.originalname)
	}
})

const upload = multer({ storage: multerStorage })

export default upload
